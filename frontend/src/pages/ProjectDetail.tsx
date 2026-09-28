import React from 'react';
import { useParams, Link } from 'react-router-dom';

// Mock hooks
const useProject = (id?: string) => {
    return {
        data: {
            id,
            name: `Project ${id}`,
            description: 'A sample project construction site.',
            team: ['John Doe', 'Jane Smith'],
            authorizedPersons: ['Admin User']
        },
        isLoading: false
    };
};

const useReports = (projectId?: string) => {
    return {
        data: [
            { id: 101, date: '2023-10-01', summary: 'Excavation started.' },
            { id: 102, date: '2023-10-02', summary: 'Foundation laid.' }
        ],
        isLoading: false
    };
};

export const ProjectDetail: React.FC = () => {
    const { id } = useParams<{ id: string }>();
    const { data: project, isLoading: projectLoading } = useProject(id);
    const { data: reports, isLoading: reportsLoading } = useReports(id);

    if (projectLoading || reportsLoading) return <div>Loading...</div>;

    return (
        <div className="p-4">
            <h1 className="text-2xl font-bold mb-2">{project?.name}</h1>
            <p className="mb-6 text-gray-700">{project?.description}</p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
                <div className="p-4 border rounded">
                    <h2 className="text-lg font-semibold mb-2">Team Members</h2>
                    <ul className="list-disc list-inside">
                        {project?.team.map(member => (
                            <li key={member}>{member}</li>
                        ))}
                    </ul>
                </div>
                <div className="p-4 border rounded">
                    <h2 className="text-lg font-semibold mb-2">Authorized Persons</h2>
                    <ul className="list-disc list-inside">
                        {project?.authorizedPersons.map(person => (
                            <li key={person}>{person}</li>
                        ))}
                    </ul>
                </div>
            </div>

            <div>
                <div className="flex justify-between items-center mb-4">
                    <h2 className="text-xl font-semibold">Reports Calendar</h2>
                    <Link to={`/projects/${id}/reports/new`} className="bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600">
                        Create Daily Report
                    </Link>
                </div>
                <div className="space-y-2">
                    {reports?.map(report => (
                        <div key={report.id} className="p-4 border rounded shadow-sm flex justify-between items-center">
                            <div>
                                <span className="font-semibold">{report.date}</span>: {report.summary}
                            </div>
                            <Link to={`/projects/${id}/reports/${report.id}`} className="text-blue-500 hover:underline">
                                View
                            </Link>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
};
